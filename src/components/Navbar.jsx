import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { LogOut, User, Camera, Menu } from 'lucide-react';

export default function Navbar({ session }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  return (
    <nav className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex">
            <Link to="/" className="flex-shrink-0 flex items-center space-x-2">
              <img src="/logo.png" alt="Proxy Logo" className="w-8 h-8 object-contain" />
              <span className="font-bold text-xl tracking-tight text-gray-900">
                Proxy
              </span>
            </Link>
          </div>
          
          <div className="flex items-center space-x-4">
            {session ? (
              <>
                <Link 
                  to="/dashboard" 
                  className="text-sm font-medium text-gray-700 hover:text-black transition-colors"
                >
                  Dashboard
                </Link>
                <Link 
                  to="/add-student" 
                  className="text-sm font-medium text-gray-700 hover:text-black transition-colors"
                >
                  Add Student
                </Link>
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center space-x-2 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-black hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-900 transition-all shadow-sm"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Logout</span>
                </button>
              </>
            ) : (
              <Link
                to="/admin"
                className="inline-flex items-center space-x-2 px-4 py-2 border border-black text-sm font-medium rounded-md text-black bg-transparent hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-900 transition-all"
              >
                <User className="w-4 h-4" />
                <span>Admin Login</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
