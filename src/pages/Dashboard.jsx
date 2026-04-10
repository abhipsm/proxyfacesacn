import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Users, UserPlus, CheckCircle, Search, Calendar, Download, Loader2, Video, VideoOff, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const CAMERA_KEY = 'proxy_camera_enabled';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('attendance'); // 'attendance' or 'students'
  const [attendance, setAttendance] = useState([]);
  const [studentsList, setStudentsList] = useState([]);
  const [studentsCount, setStudentsCount] = useState(0);
  const [todayAttendanceCount, setTodayAttendanceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(() => {
    const saved = localStorage.getItem(CAMERA_KEY);
    return saved === null ? true : saved === 'true';
  });

  const toggleCamera = () => {
    const newVal = !cameraEnabled;
    setCameraEnabled(newVal);
    localStorage.setItem(CAMERA_KEY, String(newVal));
    const channel = new BroadcastChannel('proxy_camera');
    channel.postMessage({ enabled: newVal });
    channel.close();
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      
      // Fetch students list & count
      const { data: sData, count: sCount, error: sError } = await supabase
        .from('students')
        .select('*', { count: 'exact' })
        .order('id', { ascending: false });
        
      if (!sError) {
        setStudentsList(sData || []);
        setStudentsCount(sCount || 0);
      }

      const today = new Date().toISOString().split('T')[0];

      // Fetch today's attendance count
      const { count: aCount, error: aError } = await supabase
        .from('attendance')
        .select('*', { count: 'exact', head: true })
        .eq('date', today);
        
      if (!aError) setTodayAttendanceCount(aCount || 0);

      // Fetch attendance records
      const { data: records, error: recordsError } = await supabase
        .from('attendance')
        .select(`
          id,
          date,
          time,
          status,
          students (
            name,
            hostel_name,
            college_name
          )
        `)
        .order('date', { ascending: false })
        .order('time', { ascending: false })
        .limit(100);

      if (!recordsError && records) {
        setAttendance(records);
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteStudent = async (id) => {
    if (window.confirm("Are you sure you want to delete this student and their data?")) {
      try {
        const { error } = await supabase.from('students').delete().eq('id', id);
        if (error) throw error;
        
        // Refresh data
        fetchDashboardData();
      } catch (err) {
        console.error(err);
        alert("Failed to delete student: " + err.message);
      }
    }
  };

  const filteredAttendance = attendance.filter(record => 
    record.students?.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredStudents = studentsList.filter(student => 
    student.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const generatePDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(22);
    doc.text('Proxy', 14, 20);
    doc.setFontSize(14);
    doc.setTextColor(100);
    doc.text('Attendance Report', 14, 28);
    
    let startY = 38;
    if (searchTerm) {
      doc.setFontSize(11);
      doc.setTextColor(50);
      doc.text(`Filtered by Student: ${searchTerm}`, 14, 34);
      startY = 42;
    }
    
    const tableColumn = ["Student Name", "Hostel / College", "Date", "Time", "Status"];
    const tableRows = [];

    filteredAttendance.forEach(record => {
      const rowData = [
        record.students?.name || 'Unknown',
        `${record.students?.hostel_name || '-'} / ${record.students?.college_name || '-'}`,
        record.date,
        record.time,
        record.status
      ];
      tableRows.push(rowData);
    });

    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: startY,
      theme: 'grid',
      headStyles: { fillColor: [10, 10, 10] },
    });

    const fileName = `Proxy_Attendance_${searchTerm ? searchTerm.replace(/\s+/g, '_') + '_' : ''}${new Date().toISOString().split('T')[0]}.pdf`;
    doc.save(fileName);
  };

  const downloadAllAttendance = async () => {
    try {
      setDownloadingAll(true);
      const { data: allRecords, error } = await supabase
        .from('attendance')
        .select(`
          id,
          date,
          time,
          status,
          students (
            name,
            hostel_name,
            college_name
          )
        `)
        .order('date', { ascending: false })
        .order('time', { ascending: false });

      if (error) throw error;

      if (!allRecords || allRecords.length === 0) {
        alert("No attendance records found in the database.");
        return;
      }

      const doc = new jsPDF();
      doc.setFontSize(22);
      doc.text('Proxy', 14, 20);
      doc.setFontSize(14);
      doc.setTextColor(100);
      doc.text('Complete Attendance History', 14, 28);
      
      const tableColumn = ["Student Name", "Hostel / College", "Date", "Time", "Status"];
      const tableRows = [];

      allRecords.forEach(record => {
        const rowData = [
          record.students?.name || 'Unknown',
          `${record.students?.hostel_name || '-'} / ${record.students?.college_name || '-'}`,
          record.date,
          record.time,
          record.status
        ];
        tableRows.push(rowData);
      });

      autoTable(doc, {
        head: [tableColumn],
        body: tableRows,
        startY: 38,
        theme: 'grid',
        headStyles: { fillColor: [10, 10, 10] },
      });

      doc.save(`Proxy_All_Attendance_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (err) {
      console.error(err);
      alert("Failed to download all attendance.");
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
          <p className="text-gray-500 mt-1">Overview of hostel attendance system</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={toggleCamera}
            className={`inline-flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors shadow-sm font-medium text-sm ${
              cameraEnabled
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-gray-200 hover:bg-gray-300 text-gray-600'
            }`}
          >
            {cameraEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
            <span>{cameraEnabled ? 'Camera ON' : 'Camera OFF'}</span>
            <div className={`w-10 h-5 rounded-full ml-1 relative transition-colors ${
              cameraEnabled ? 'bg-green-400' : 'bg-gray-400'
            }`}>
              <div className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all shadow-sm ${
                cameraEnabled ? 'right-0.5' : 'left-0.5'
              }`} />
            </div>
          </button>
          <Link 
            to="/add-student"
            className="inline-flex items-center space-x-2 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors shadow-sm"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Student</span>
          </Link>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center space-x-4">
          <div className="w-12 h-12 bg-gray-50 rounded-full flex items-center justify-center">
            <Users className="w-6 h-6 text-gray-700" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Total Registered Students</p>
            <p className="text-2xl font-bold text-gray-900">{loading ? '-' : studentsCount}</p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center space-x-4">
          <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center">
            <CheckCircle className="w-6 h-6 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500">Present Today</p>
            <p className="text-2xl font-bold text-gray-900">{loading ? '-' : todayAttendanceCount}</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex space-x-4 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('attendance')}
          className={`py-2 px-4 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'attendance'
              ? 'border-black text-black'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Attendance Records
        </button>
        <button
          onClick={() => setActiveTab('students')}
          className={`py-2 px-4 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'students'
              ? 'border-black text-black'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Manage Students
        </button>
      </div>

      {/* List Container */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex flex-col xl:flex-row justify-between items-center bg-white gap-4 w-full">
          <div className="flex items-center space-x-2 min-w-max">
            {activeTab === 'attendance' ? (
              <Calendar className="w-5 h-5 text-gray-500" />
            ) : (
              <Users className="w-5 h-5 text-gray-500" />
            )}
            <h2 className="text-lg font-medium text-gray-900">
              {activeTab === 'attendance' ? 'Attendance Records' : 'Manage Students'}
            </h2>
          </div>

          <div className="flex flex-col sm:flex-row items-center space-y-3 sm:space-y-0 sm:space-x-3 w-full xl:w-auto">
            <div className="relative w-full sm:w-64">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="Search student..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm"
              />
            </div>
            
            {activeTab === 'attendance' && (
              <div className="flex space-x-3 w-full sm:w-auto">
                <button
                  onClick={generatePDF}
                  disabled={filteredAttendance.length === 0}
                  className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <Download className="w-4 h-4" />
                  <span>Export View</span>
                </button>
                
                <button
                  onClick={downloadAllAttendance}
                  disabled={downloadingAll}
                  className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {downloadingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  <span>Download All</span>
                </button>
              </div>
            )}
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              {activeTab === 'attendance' ? (
                 <tr>
                   <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                     Student Info
                   </th>
                   <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                     Date & Time
                   </th>
                   <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                     Status
                   </th>
                 </tr>
              ) : (
                 <tr>
                   <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                     Student Info
                   </th>
                   <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                     Details
                   </th>
                   <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                     Action
                   </th>
                 </tr>
              )}
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan="3" className="px-6 py-12 text-center text-gray-500">
                    Loading records...
                  </td>
                </tr>
              ) : activeTab === 'attendance' ? (
                filteredAttendance.length === 0 ? (
                  <tr>
                    <td colSpan="3" className="px-6 py-12 text-center text-gray-500">
                      {searchTerm ? "No records found for that student." : "No attendance records found."}
                    </td>
                  </tr>
                ) : (
                  filteredAttendance.map((record) => (
                    <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="h-10 w-10 flex-shrink-0 bg-gray-100 rounded-full flex items-center justify-center">
                            <span className="font-medium text-gray-600">
                              {record.students?.name?.charAt(0) || 'S'}
                            </span>
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">{record.students?.name || 'Unknown Student'}</div>
                            <div className="text-sm text-gray-500">{record.students?.hostel_name || '-'} • {record.students?.college_name || '-'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{record.date}</div>
                        <div className="text-sm text-gray-500">{record.time}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                          {record.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )
              ) : (
                filteredStudents.length === 0 ? (
                  <tr>
                    <td colSpan="3" className="px-6 py-12 text-center text-gray-500">
                      {searchTerm ? "No students found." : "No students registered."}
                    </td>
                  </tr>
                ) : (
                  filteredStudents.map((student) => (
                    <tr key={student.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="h-10 w-10 flex-shrink-0 bg-gray-100 rounded-full flex items-center justify-center border border-gray-200 shadow-sm">
                            <span className="font-medium text-gray-600">
                              {student.name?.charAt(0) || 'S'}
                            </span>
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">{student.name}</div>
                            <div className="text-sm text-gray-500">{student.email || 'No email provided'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{student.hostel_name || '-'} / {student.college_name || '-'}</div>
                        <div className="text-sm text-gray-500">Age: {student.age || '-'} • Ph: {student.phone || '-'}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <button
                          onClick={() => deleteStudent(student.id)}
                          className="inline-flex items-center justify-center p-2 rounded-lg text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="Delete Student"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
